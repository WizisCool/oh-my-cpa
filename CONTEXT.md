# OMC domain language

OMC owns operator-facing identity and observability above CPA's execution plane.
This is the shared vocabulary, not an API or configuration catalog.

## Identity and execution

**Source**: The business origin of capacity, such as a vendor, reseller or subscription.
It is not necessarily the same thing as a protocol driver.

**Connection**: A user-owned usable line within a Source, carrying its name and other
organizational metadata independently of the discovered CPA resource.

**Credential**: The API-key or OAuth material CPA uses to execute an upstream request.
Credential metadata describes it without exposing that material.

**CPA Binding**: The association between an OMC identity and a resource in one CPA
instance. It is scoped to the resource family; a configuration array position is not identity.

**Protocol Driver**: CPA's adapter for an upstream protocol. A display provider name
is a user-facing label, not necessarily the driver's or OAuth provider's identifier.

**Client Key**: A key clients use to call CPA. A **Client Key Alias** is OMC's durable
label for that key; its display mask is not a join key.

**Call Point**: A model name a client may request from CPA. Aliases can make several
call points resolve to the same upstream model.

**Served Model**: The model reported by the upstream response. It is evidence of what
answered, not a replacement for the client's requested model or call point.

**Unclaimed Resource**: A discovered CPA resource that has not been assigned to a
user-owned Connection. Disappearance does not erase its historical usage.

## Usage and billing

**Request Record**: One recorded execution attempt, including timing, token usage,
identity and any locked cost. Retries can produce several attempts for one client action.

**Usage Facts**: Durable aggregated request/token/cost facts used by dashboards after
individual request records expire. Missing detail is not evidence of zero traffic.

**Unrecorded Refusal**: A gateway refusal before the usage publisher records an
attempt. It is not visible as a normal request record.

**Time Window**: A resolved interval of instants. Calendar presets use the deployment's
time zone; a quota provider's reset cycle is a different window.

**Model Price**: The price policy for a model: base rates, optional tiers and a model
multiplier. A **Channel Multiplier** scales usage served by a CPA provider.

**Price Version**: An immutable revision of a price policy. A **Request Cost Snapshot**
locks the price evidence and calculated cost of a recorded attempt.

**Price Tier**: One conditional rate override, selected by service tier, prompt size
and/or billing-clock window. Applicable tiers do not stack.

**Resolved Service Tier**: The billed lane selected from the request's available
outbound/request/response evidence. It is distinct from the client's original request.

**Unpriced Usage**: A recorded request without sufficient pricing evidence. It is not
free usage and must not be represented as an observed zero cost.

**Quota Reading**: What an upstream published at an observation time. Unknown,
unpublished, stale and failed are not interchangeable with exhausted or zero.

**Estimated Window Capacity**: Recorded usage divided by the observed used share of
a quota cycle. A **Previous-Cycle Capacity Reference** is historical evidence, not a
current measurement or a routing instruction.

**Window Warmup**: A policy-approved request intended to activate a credential's
billing window. An uncertain attempt is not permission to issue another one.

## Console and automation

**Preference**: Allowlisted, server-stored console presentation state. It is separate
from CPA configuration and does not grant execution authority.

**Configuration Change Set**: Named configuration paths changed against a loaded
revision. A **Configuration Backup** is the encrypted stored file captured before a write.

**Agent**: OMC's model-assisted operator workspace. A **Capability** is a declared,
authorized OMC operation it can invoke; an **Operation** is one prepared execution.

**Playground**: A debugging workspace for a model already callable through CPA,
without the Agent's OMC tool loop.

**Browser Run**: A server-owned execution with a reconnectable browser subscription.
Disconnecting the subscription is different from explicitly stopping the execution.

**Plugin Host**: The authenticated same-origin host for trusted installed CPA plugin
pages. It has a deliberately different credential boundary from ordinary console DTOs.

**Audit Trail**: The security record of operator/agent actions, distinct from CPA's
request logs and OMC's service logs.

**Updater**: The separate Docker-authorized process that applies product updates.
An **Update Check** only observes releases; it does not install them.

**Pinned Image**: An image fixed by version tag or digest. Automatic updates preserve
that choice so a later deployment command cannot silently downgrade the database.
