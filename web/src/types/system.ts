/**
 * System Information page wire contract.
 *
 * Two rules shape these types, and both come from the backend being deliberately
 * unwilling to guess:
 *
 *   - An unmeasured value is `null`, never `0` and never a default. A `-wal` file
 *     that does not exist, a pragma the database declined to answer, and a check
 *     that has never run are all different from a measured zero, and the page says
 *     which one it is looking at.
 *   - A version answer is a state, not a boolean. `update_available | up_to_date |
 *     update_ahead | indeterminate` exists because "the running build is a
 *     development or fork build" is not the same claim as "you are up to date".
 */

/** The products whose versions this page reports. */
export type ReleaseProduct = 'omc' | 'cpa';

/**
 * How the running version compares with the newest published release.
 *
 * `indeterminate` is a real answer, not an error: see `reason`.
 */
export type UpdateState = 'update_available' | 'up_to_date' | 'update_ahead' | 'indeterminate';

/**
 * Why a comparison could not be made. These are separate because the copy differs:
 * a development build is normal, a failed check is actionable.
 */
export type UpdateReason =
  | 'running_version_not_comparable'
  | 'newest_release_not_comparable'
  | 'no_releases_published'
  | 'not_checked_yet';

/** Connection state of the gateway. */
export interface SystemCPAInfo {
  status: string;
  endpoint_masked: string;
  latency_ms: number;
}

/** Background usage collector state. */
export interface SystemCollectorInfo {
  status: string;
  mode: string;
  gap_count: number;
}

/**
 * The database's own answer about itself, read from the live connection.
 *
 * `journal_mode` is observed rather than assumed, which is why `wal_mode` is derived
 * from it instead of being a constant.
 */
export interface SystemDatabaseInfo {
  status: string;
  driver: string;
  journal_mode: string;
  wal_mode: boolean;
  /** Null when the connection did not answer for the setting. */
  synchronous: number | null;
  foreign_keys: number | null;
  busy_timeout_ms: number | null;
  schema_version: number;
  page_size: number;
  page_count: number;
  /** Pages on the free list. Reused by later writes; not reclaimable disk space. */
  freelist_count: number;
  used_bytes: number;
  free_page_bytes: number;
  files: SystemDatabaseFiles;
}

/**
 * Observed file sizes, each measured separately.
 *
 * A missing WAL file is reported as `wal_exists: false` with `wal_bytes: 0`, so the
 * page can distinguish "no WAL file" from "an empty WAL file" instead of printing a
 * zero that means neither.
 */
export interface SystemDatabaseFiles {
  main_bytes: number;
  main_exists: boolean;
  wal_bytes: number;
  wal_exists: boolean;
  shm_bytes: number;
  shm_exists: boolean;
  total_bytes: number;
}

/** One product's version answer. */
export interface SystemProductVersion {
  product: ReleaseProduct;
  /** The version running here, empty when the gateway never reported one. */
  running_version: string;
  /** Newest published release known, empty when none is known. */
  latest_version: string;
  state: UpdateState;
  reason: UpdateReason | '';
  repository: string;
  repository_url: string;
  /** When the stored index was last successfully read. Null when never. */
  checked_at_ms: number | null;
  /** When a check was last attempted, successful or not. Null when never. */
  attempted_at_ms: number | null;
  /** Redacted failure sentence for the last attempt, empty when it succeeded. */
  check_error: string;
  checking: boolean;
  /** How many releases the merged change log contains. */
  merge_count: number;
  /** False when the release walk stopped early, so the range is not fully known. */
  range_complete: boolean;
  /** False when this process holds no release notes (after a restart, or offline). */
  notes_available: boolean;
}

/** Record counts, so a size can be read against the data that produced it. */
export interface SystemDataVolumes {
  usage_events: number;
  error_events: number;
  inbox_pending: number;
  first_event_ms: number | null;
  last_event_ms: number | null;
  audit_events: number;
  credentials: number | null;
  providers: number | null;
  plugins: number | null;
}

/**
 * Maintenance job state.
 *
 * `incomplete` distinguishes "the statement ran" from "the statement did its job":
 * SQLite does not raise an error when a checkpoint is blocked, so a success message
 * derived from a nil error would claim a rebuild happened when nothing did.
 */
export interface SystemMaintenanceStatus {
  action: string;
  running: boolean;
  started_at_ms: number;
  finished_at_ms: number;
  size_before_bytes: number;
  size_after_bytes: number;
  reclaimed_bytes: number;
  incomplete: boolean;
  detail: string;
  error: string;
}

/** What VACUUM would need, so the confirmation can state it before it is run. */
export interface SystemMaintenanceAdmission {
  action: string;
  /** Bytes required: SQLite documents up to twice the database file. */
  required_bytes: number;
  available_bytes: number;
  /** False when the requirement cannot be met; the action must then be refused. */
  allowed: boolean;
  reason: string;
}

/** Runtime and build facts. */
export interface SystemRuntimeInfo {
  go_version: string;
  os_arch: string;
  pid: number;
  started_at_ms: number;
  num_goroutines: number;
  alloc_mb: number;
  sys_mb: number;
  num_gc: number;
}

/** The whole page, in one response. */
export interface SystemInfoResponse {
  omc_version: SystemProductVersion;
  cpa_version: SystemProductVersion;
  uptime_seconds: number;
  database: SystemDatabaseInfo;
  cpa: SystemCPAInfo;
  collector: SystemCollectorInfo;
  data_volumes: SystemDataVolumes;
  maintenance: SystemMaintenanceStatus;
  maintenance_admission: SystemMaintenanceAdmission;
  runtime: SystemRuntimeInfo;
}

/** Answer to a maintenance status query or action start. */
export interface SystemMaintenanceResponse {
  maintenance: SystemMaintenanceStatus;
  maintenance_admission: SystemMaintenanceAdmission;
}

/** One release in a merged change log. */
export interface SystemReleaseEntry {
  tag: string;
  name: string;
  published_at_ms: number;
  prerelease: boolean;
  /** Markdown release notes. Untrusted remote text; rendered without raw HTML. */
  body: string;
  html_url: string;
  /** True when this release lies between the running version and the newest one. */
  in_range: boolean;
  /** False when this process does not hold the notes; the entry still names the release. */
  body_available: boolean;
}

/** One product's merged change log. */
export interface SystemReleasesResponse {
  product: ReleaseProduct;
  repository: string;
  repository_url: string;
  running_version: string;
  latest_version: string;
  state: UpdateState;
  reason: UpdateReason | '';
  /** False when the release walk stopped early. */
  range_complete: boolean;
  checked_at_ms: number | null;
  attempted_at_ms: number | null;
  check_error: string;
  checking: boolean;
  releases: SystemReleaseEntry[];
}
