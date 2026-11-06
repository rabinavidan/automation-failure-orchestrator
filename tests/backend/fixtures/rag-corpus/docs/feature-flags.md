# Feature flags

Feature flags are evaluated per tenant and cached for sixty seconds. A test that toggles a flag
must wait for the cache to expire or call the flag service directly with a cache bypass header.
