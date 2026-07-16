export interface UpdateStatus {
  readonly currentVersion: string;
  readonly latestVersion?: string | undefined;
  readonly updateAvailable: boolean;
}


export interface UpdatesPort {
  check(): Promise<UpdateStatus>;
}
