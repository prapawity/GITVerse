export async function runUpdate(
  downloaded: boolean,
  manualInstall: boolean,
  download: () => Promise<unknown>,
  install: () => Promise<unknown>,
) {
  if (!downloaded) await download();
  if (!manualInstall || downloaded) await install();
}
