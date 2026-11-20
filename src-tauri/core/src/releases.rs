//! GitHub release list and release-page URLs (port of listReleases / isReleaseDownloadUrl in
//! electron/updates.ts). Installing updates is the Tauri updater's job; this only lists releases.
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const RELEASES_URL: &str = "https://github.com/prapawity/GITVerse-by-PRAPAWITY/releases";
const API: &str = "https://api.github.com/repos/prapawity/GITVerse-by-PRAPAWITY/releases";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReleaseUpdate {
    pub version: String,
    pub url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// A stable `X.Y.Z` (an optional leading `v`), like semver's `valid()` without pre-releases.
pub fn stable_version(tag: &str) -> Option<(u64, u64, u64)> {
    let v = tag.strip_prefix('v').unwrap_or(tag);
    let mut parts = v.split('.');
    let mut next = || -> Option<u64> {
        let p = parts.next()?;
        if p.is_empty()
            || (p.len() > 1 && p.starts_with('0'))
            || !p.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        p.parse().ok()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

pub fn tag_url(tag: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    format!("{RELEASES_URL}/tag/{encoded}")
}

fn collect(releases: Vec<Release>, out: &mut Vec<ReleaseUpdate>) {
    for r in releases {
        if r.draft || r.prerelease {
            continue;
        }
        if let Some((a, b, c)) = stable_version(&r.tag_name) {
            out.push(ReleaseUpdate {
                version: format!("{a}.{b}.{c}"),
                url: tag_url(&r.tag_name),
            });
        }
    }
}

fn sort(out: &mut [ReleaseUpdate]) {
    out.sort_by_key(|r| std::cmp::Reverse(stable_version(&r.version)));
}

pub async fn list_releases() -> Result<Vec<ReleaseUpdate>, String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("GITVerse by PRAPAWITY")
        .build()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for page in 1..=10 {
        let res = http
            .get(format!("{API}?per_page=100&page={page}"))
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await
            .map_err(|e| format!("GitHub release list failed: {e}"))?;
        if res.status() == 404 {
            break;
        }
        if !res.status().is_success() {
            return Err(format!(
                "GitHub release list failed (HTTP {}).",
                res.status().as_u16()
            ));
        }
        let entries: Vec<Release> = res.json().await.map_err(|e| e.to_string())?;
        let n = entries.len();
        collect(entries, &mut out);
        if n < 100 {
            break;
        }
    }
    sort(&mut out);
    Ok(out)
}

/// Only GitHub release pages of this repository may be opened from the update UI.
pub fn is_release_page(value: &str) -> bool {
    let Ok(u) = url::Url::parse(value) else {
        return false;
    };
    const PREFIX: &str = "/prapawity/GITVerse-by-PRAPAWITY/releases/tag/";
    u.scheme() == "https"
        && u.host_str() == Some("github.com")
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none()
        && u.query().is_none()
        && u.fragment().is_none()
        && u.path().strip_prefix(PREFIX).is_some_and(|tag| {
            let tag = url::form_urlencoded::parse(format!("t={tag}").as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            stable_version(&tag).is_some()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(stable_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(stable_version("10.0.0"), Some((10, 0, 0)));
        for bad in ["v1.2", "1.2.3-beta.1", "01.2.3", "v1.2.3.4", "latest", ""] {
            assert_eq!(stable_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn lists_stable_published_releases_newest_first() {
        let json = r#"[
            {"tag_name":"v1.2.0"},{"tag_name":"v1.10.0"},{"tag_name":"v2.0.0","draft":true},
            {"tag_name":"v1.9.0","prerelease":true},{"tag_name":"v1.11.0-rc.1"},{"tag_name":"nightly"}
        ]"#;
        let mut out = Vec::new();
        collect(serde_json::from_str(json).unwrap(), &mut out);
        sort(&mut out);
        let versions: Vec<_> = out.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(versions, ["1.10.0", "1.2.0"]);
        assert_eq!(out[0].url, format!("{RELEASES_URL}/tag/v1.10.0"));
    }

    #[test]
    fn release_page_urls() {
        assert!(is_release_page(
            "https://github.com/prapawity/GITVerse-by-PRAPAWITY/releases/tag/v1.2.3"
        ));
        for bad in [
            "http://github.com/prapawity/GITVerse-by-PRAPAWITY/releases/tag/v1.2.3",
            "https://github.com/prapawity/GITVerse-by-PRAPAWITY/releases/tag/v1.2.3?x=1",
            "https://github.com/prapawity/GITVerse-by-PRAPAWITY/releases/tag/v1.2.3#a",
            "https://user@github.com/prapawity/GITVerse-by-PRAPAWITY/releases/tag/v1.2.3",
            "https://github.com/someone/else/releases/tag/v1.2.3",
            "https://github.com/prapawity/GITVerse-by-PRAPAWITY/releases/tag/nightly",
            "https://evil.example/prapawity/GITVerse-by-PRAPAWITY/releases/tag/v1.2.3",
        ] {
            assert!(!is_release_page(bad), "{bad}");
        }
    }
}
