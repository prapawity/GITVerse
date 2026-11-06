export interface ScanProgress {
  scanned: number;
  repositories: number;
  skipped: number;
  folder: string;
}

export interface ScanResult {
  root: string;
  group: string;
  repos: string[];
  skipped: number;
  cancelled: boolean;
}
