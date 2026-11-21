//! Pull/merge request hosting: one authenticated API call per request, mirroring
//! electron/hosting.ts and the checks in src/shared/pullRequests.ts. Provider logic lives in the
//! renderer; this only validates the request, attaches the token saved for that exact host, and
//! returns the JSON.
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::secrets::SecretStore;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Github,
    Gitlab,
    Bitbucket,
}

impl HostKind {
    fn name(self) -> &'static str {
        match self {
            HostKind::Github => "github",
            HostKind::Gitlab => "gitlab",
            HostKind::Bitbucket => "bitbucket",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct HostRequest {
    pub kind: HostKind,
    pub host: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct HostResponse {
    pub status: u16,
    pub data: Value,
}

/// `HOST_RE` in pullRequests.ts: a DNS name with an optional port.
fn valid_host(host: &str) -> bool {
    let (name, port) = match host.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    !name.is_empty()
        && name.len() <= 253
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
}

pub fn check_host(kind: HostKind, host: &str) -> Result<()> {
    if !valid_host(host) {
        return Err(AppError::Invalid("Invalid host.".into()));
    }
    if kind == HostKind::Bitbucket && !host.eq_ignore_ascii_case("bitbucket.org") {
        return Err(AppError::Invalid(
            "Only Bitbucket Cloud (bitbucket.org) is supported.".into(),
        ));
    }
    Ok(())
}

pub fn check_request(r: &HostRequest) -> Result<()> {
    check_host(r.kind, &r.host)?;
    if r.method != "GET" && r.method != "POST" {
        return Err(AppError::Invalid("Unsupported request method.".into()));
    }
    let p = &r.path;
    if !p.starts_with('/')
        || p.len() > 2000
        || p.contains("//")
        || p.split(['/', '?']).any(|segment| segment == "..")
        || p.contains('@')
        || p.contains('\\')
        || p.chars().any(char::is_whitespace)
    {
        return Err(AppError::Invalid("Invalid API path.".into()));
    }
    Ok(())
}

pub fn api_base(kind: HostKind, host: &str) -> String {
    let host = host.to_ascii_lowercase();
    match kind {
        HostKind::Github if host == "github.com" => "https://api.github.com".into(),
        HostKind::Github => format!("https://{host}/api/v3"),
        HostKind::Gitlab => format!("https://{host}/api/v4"),
        HostKind::Bitbucket => "https://api.bitbucket.org/2.0".into(),
    }
}

/// Whether `url` is an https page on the repository's own web host (`webUrlAllowed` in TS).
pub fn web_url_allowed(kind: HostKind, host: &str, url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let mut origin = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if let Some(port) = parsed.port() {
        origin = format!("{origin}:{port}");
    }
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && check_host(kind, host).is_ok()
        && origin == host.to_ascii_lowercase()
}

pub fn token_key(kind: HostKind, host: &str) -> String {
    format!(
        "hosting.token.{}.{}",
        kind.name(),
        host.to_ascii_lowercase()
    )
}

pub async fn request(secrets: &dyn SecretStore, r: HostRequest) -> Result<HostResponse> {
    check_request(&r)?;
    let token = secrets.get(&token_key(r.kind, &r.host));
    send(&r, token.as_deref()).await
}

async fn send(r: &HostRequest, token: Option<&str>) -> Result<HostResponse> {
    // verify certificates with the OS (Keychain / Windows store / system CAs), so company GitLab
    // servers signed by an internal CA work like they do in the browser
    let tls = {
        use rustls_platform_verifier::ConfigVerifierExt;
        rustls::ClientConfig::with_platform_verifier()
            .map_err(|e| AppError::Invalid(format!("Could not load system certificates: {e}")))?
    };
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        // follow redirects only within the API host, so the token never leaves it
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let same = attempt.url().host_str() == attempt.previous()[0].host_str()
                && attempt.url().port_or_known_default()
                    == attempt.previous()[0].port_or_known_default()
                && attempt.url().scheme() == "https";
            if attempt.previous().len() > 3 {
                attempt.error("too many redirects")
            } else if same {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .timeout(Duration::from_secs(30))
        .user_agent("GITVerse")
        .build()
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    let url = api_base(r.kind, &r.host) + &r.path;
    let mut req = if r.method == "POST" {
        client.post(&url)
    } else {
        client.get(&url)
    };
    req = req.header(
        "Accept",
        if r.kind == HostKind::Github {
            "application/vnd.github+json"
        } else {
            "application/json"
        },
    );
    if let Some(token) = token {
        req = match r.kind {
            HostKind::Gitlab => req.header("PRIVATE-TOKEN", token),
            HostKind::Bitbucket if token.contains(':') => req.header(
                "Authorization",
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(token)
                ),
            ),
            _ => req.header("Authorization", format!("Bearer {token}")),
        };
    }
    if let Some(body) = &r.body {
        req = req.json(body);
    }
    let response = req.send().await.map_err(|e| {
        use std::error::Error;
        let mut detail = e.to_string();
        let mut source = e.source();
        while let Some(cause) = source {
            detail = format!("{detail}: {cause}");
            source = cause.source();
        }
        AppError::Invalid(format!("Could not reach {}: {detail}", r.host))
    })?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    let data = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    Ok(HostResponse { status, data })
}

/// `ConnectResult` in pullRequests.ts.
#[derive(Debug, Serialize, Default)]
pub struct ConnectResult {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub tried: Vec<String>,
}

/// `accountName` in pullRequests.ts.
fn account_name(data: &Value) -> String {
    ["login", "username", "display_name", "nickname", "name"]
        .iter()
        .find_map(|k| data.get(k).and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

/// The account a token signs in as, or None when the host rejects it.
async fn verify(kind: HostKind, host: &str, token: &str) -> Option<String> {
    let r = HostRequest {
        kind,
        host: host.to_owned(),
        method: "GET".into(),
        path: "/user".into(),
        body: None,
    };
    match send(&r, Some(token)).await {
        Ok(res) if res.status == 200 => {
            let name = account_name(&res.data);
            Some(if name.is_empty() {
                "signed in".into()
            } else {
                name
            })
        }
        _ => None,
    }
}

/// GUI apps on macOS do not get the shell PATH, so look where package managers install CLIs too.
fn find_tool(name: &str) -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(Into::into))
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

async fn run(file: &std::path::Path, args: &[&str], input: &str) -> String {
    use tokio::io::AsyncWriteExt;
    let child = tokio::process::Command::new(file)
        .args(args)
        // never open a prompt or browser while looking for saved credentials
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else {
        return String::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
    }
    match tokio::time::timeout(Duration::from_secs(8), child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

/// Credentials the user chose to check that might work as an API token, most likely first.
async fn candidates(kind: HostKind, host: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    let mut add = |source: &str, token: Option<String>| {
        if let Some(t) = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
            if !found.iter().any(|(_, existing)| *existing == t) {
                found.push((source.to_owned(), t));
            }
        }
    };
    // The host goes into git's line-based credential protocol: never let it add lines.
    if host.is_empty() || host.contains(['\n', '\r', '\0', '=']) {
        return found;
    }
    let git = find_tool("git").unwrap_or_else(|| "git".into());
    let filled = run(
        &git,
        &["credential", "fill"],
        &format!("protocol=https\nhost={host}\n\n"),
    )
    .await;
    let field = |name: &str| {
        filled
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}=")).map(str::to_owned))
    };
    if let Some(password) = field("password") {
        let token = match (kind, field("username")) {
            (HostKind::Bitbucket, Some(user)) => format!("{user}:{password}"),
            _ => password,
        };
        add("Git saved login", Some(token));
    }
    match kind {
        HostKind::Github => {
            if let Some(gh) = find_tool("gh") {
                add(
                    "GitHub CLI (gh)",
                    Some(run(&gh, &["auth", "token", "--hostname", host], "").await),
                );
            }
            if host == "github.com" {
                add(
                    "GITHUB_TOKEN",
                    std::env::var("GH_TOKEN")
                        .or_else(|_| std::env::var("GITHUB_TOKEN"))
                        .ok(),
                );
            }
        }
        HostKind::Gitlab => {
            if let Some(glab) = find_tool("glab") {
                add(
                    "GitLab CLI (glab)",
                    Some(run(&glab, &["config", "get", "token", "--host", host], "").await),
                );
            }
            // an environment token belongs to gitlab.com; never offer it to another server
            if host == "gitlab.com" {
                add("GITLAB_TOKEN", std::env::var("GITLAB_TOKEN").ok());
            }
        }
        HostKind::Bitbucket => {}
    }
    found
}

/// Check a new token before saving it, or the saved one; otherwise look for Git/CLI credentials
/// after the user explicitly chooses to check them.
pub async fn connect(
    secrets: &dyn SecretStore,
    kind: HostKind,
    host: &str,
    entered: Option<String>,
) -> Result<ConnectResult> {
    check_host(kind, host)?;
    let key = token_key(kind, host);
    if let Some(token) = entered
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
    {
        return Ok(match verify(kind, host, &token).await {
            Some(account) => {
                secrets.set(&key, Some(&token))?;
                ConnectResult {
                    connected: true,
                    account: Some(account),
                    source: Some("access token".into()),
                    tried: vec![],
                }
            }
            None => ConnectResult {
                tried: vec!["the token you entered".into()],
                ..Default::default()
            },
        });
    }
    let mut tried = Vec::new();
    if let Some(saved) = secrets.get(&key) {
        if let Some(account) = verify(kind, host, &saved).await {
            return Ok(ConnectResult {
                connected: true,
                account: Some(account),
                source: Some("access token".into()),
                tried,
            });
        }
        tried.push("saved access token".into());
    }
    for (source, token) in candidates(kind, host).await {
        tried.push(source.clone());
        if let Some(account) = verify(kind, host, &token).await {
            secrets.set(&key, Some(&token))?;
            return Ok(ConnectResult {
                connected: true,
                account: Some(account),
                source: Some(source),
                tried,
            });
        }
    }
    Ok(ConnectResult {
        tried,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: HostKind, host: &str, path: &str) -> HostRequest {
        HostRequest {
            kind,
            host: host.into(),
            method: "GET".into(),
            path: path.into(),
            body: None,
        }
    }

    /// Live check against a real server: HOSTING_LIVE_HOST=gitlab.example.com cargo test -- --ignored live
    #[tokio::test]
    #[ignore]
    async fn live_server_certificate_is_trusted() {
        let Ok(host) = std::env::var("HOSTING_LIVE_HOST") else {
            return;
        };
        let secrets = crate::secrets::MemoryStore::default();
        let response = request(&secrets, req(HostKind::Gitlab, &host, "/version"))
            .await
            .expect("server reachable with the OS certificate store");
        // 401 without a token is fine: TLS and HTTP worked
        assert!(
            response.status == 200 || response.status == 401,
            "{}",
            response.status
        );
    }

    #[test]
    fn bases_match_the_typescript_contract() {
        assert_eq!(
            api_base(HostKind::Github, "github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            api_base(HostKind::Github, "github.acme.io"),
            "https://github.acme.io/api/v3"
        );
        assert_eq!(
            api_base(HostKind::Gitlab, "GitLab.acme.io:8443"),
            "https://gitlab.acme.io:8443/api/v4"
        );
        assert_eq!(
            token_key(HostKind::Gitlab, "GitLab.com"),
            "hosting.token.gitlab.gitlab.com"
        );
    }

    #[test]
    fn rejects_requests_that_could_leave_the_api() {
        assert!(check_request(&req(
            HostKind::Github,
            "github.com",
            "/repos/a/b/pulls?state=closed"
        ))
        .is_ok());
        for path in ["repos", "//evil.com/x", "/a/../b", "/a@evil.com", "/a b"] {
            assert!(
                check_request(&req(HostKind::Github, "github.com", path)).is_err(),
                "{path}"
            );
        }
        for host in [
            "",
            "evil.com/x",
            "a..b:",
            "-a.com",
            "a.com:99999x",
            "user@a.com",
        ] {
            assert!(
                check_request(&req(HostKind::Github, host, "/x")).is_err(),
                "{host}"
            );
        }
        assert!(check_request(&req(HostKind::Bitbucket, "bitbucket.example.com", "/x")).is_err());
        assert!(web_url_allowed(
            HostKind::Github,
            "github.com",
            "https://github.com/a/b/pull/1"
        ));
        assert!(!web_url_allowed(
            HostKind::Github,
            "github.com",
            "https://evil.com/a"
        ));
        assert!(!web_url_allowed(
            HostKind::Github,
            "github.com",
            "http://github.com/a"
        ));
        assert!(!web_url_allowed(
            HostKind::Github,
            "github.com",
            "https://x@github.com/a"
        ));
    }
}
