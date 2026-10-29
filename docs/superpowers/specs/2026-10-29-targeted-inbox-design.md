# Exact inbox reply inspection (#691)

The authorized design adds a read-only exact inspection mode to `msg inbox`.
Seven mandatory selectors bind the externally preclassified safe incoming UUID,
exact owner UUID, sender node UUID, exact raw sender reference, full outgoing
target-session UUID, original sent UUID and known text SHA-256. The raw sender
reference may be a name or UUID, and its relationship to the target UUID must
come from trusted external evidence. This path never resolves an alias. These inputs are not semantic classification evidence.
Without an externally known safe ID and hash, this mode remains unavailable.

Preflight rejects incomplete, malformed, duplicate or mixed modes and selector
spellings after the inbox option terminator, verifies the existing
caller identity, then reads only the selected authored-safe sent root and checks
its exact owner and full destination. An ordinary threaded sent parent is
allowed after validating its optional parent UUID, without following it. No
incoming or sent directory listing is allowed.
Under the existing selected-record lock it opens only that incoming regular
nonsymlink file, with a bounded descriptor read and change detection. The stored
envelope is checked after this preauthorized read, not independently attested
before it. Exact owner, sender, reply root and text hash must match; proxy and
forwarded records fail closed. Output is one bounded JSON object containing
only validated selected fields. Errors are fixed opaque codes without content.

Legacy broad inspection, delivery, status and receive behavior remain unchanged.
No sidecar, protocol, guard, permission or runtime installation changes are made.
Synthetic tests instrument filesystem reads and enumeration, prove zero incoming
reads on preflight failures, one selected record on success, and unchanged bytes.
