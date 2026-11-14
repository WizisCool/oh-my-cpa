# Time zone

Set `TZ=Asia/Kuala_Lumpur` (or another IANA timezone) in the deployment environment to
choose the server calendar. The supplied Compose files pass `TZ` to both OMC and CPA and
default to `UTC`. For a standalone container, pass `-e TZ=Asia/Kuala_Lumpur`. Native
deployments otherwise use the operating system timezone.

In **OMC Settings → Time zone**, the server zone is selected automatically and marked
**Server time zone**. Every option includes its current UTC offset. A manual choice is
persisted for the deployment; selecting the server zone restores the deployment default.
Timestamp displays, calendar selections, daily totals and OMC service logs use this
setting without rewriting stored instants. CPA log timestamps with `Z` or a numeric UTC
offset are converted to the effective display timezone. Timestamps without an offset
retain their original wall-clock text: CPA's log response does not identify their source
timezone. Raw log downloads and explicit UTC pricing-tier rules retain their source
semantics.
