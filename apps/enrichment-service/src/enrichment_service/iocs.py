"""IOC normalization and eligibility checks.

Two security-relevant rules live here:

* Defanged indicators (``hxxp://evil[.]com``) are refanged so lookups work.
* Internal indicators (RFC 1918 / loopback / link-local IPs, internal hosts and
  users) are never sent to third-party threat-intel providers.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass

from .models import Indicator

_HASH_LENGTHS = {32: "md5", 40: "sha1", 64: "sha256"}
_HEX = re.compile(r"^[0-9a-f]+$")
_DOMAIN = re.compile(r"^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*\.[a-z]{2,63}$")

# Indicator types that describe internal identity, not external threat intel.
_INTERNAL_TYPES = {"user", "host", "process", "email"}

# RFC 5737 / RFC 3849 documentation ranges. Not globally routable, but used by
# demos and tests, so mock mode treats them as public.
DOCUMENTATION_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")
)


@dataclass(frozen=True)
class NormalizedIndicator:
    indicator: Indicator
    value: str
    skipped_reason: str | None = None
    hash_type: str | None = None

    @property
    def eligible(self) -> bool:
        return self.skipped_reason is None


def refang(value: str) -> str:
    out = value.strip()
    out = re.sub(r"^hxxp", "http", out, flags=re.IGNORECASE)
    for fanged, plain in (("[.]", "."), ("(.)", "."), ("{.}", "."), ("[:]", ":"), ("[at]", "@")):
        out = out.replace(fanged, plain)
    return out


def is_documentation_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return any(ip.version == net.version and ip in net for net in DOCUMENTATION_NETWORKS)


def normalize(
    indicator: Indicator, *, allow_documentation_ranges: bool = False
) -> NormalizedIndicator:
    value = refang(indicator.value)

    if indicator.type in _INTERNAL_TYPES:
        return NormalizedIndicator(
            indicator, value, "internal identity; not sent to external providers"
        )

    if indicator.type == "ip":
        try:
            ip = ipaddress.ip_address(value)
        except ValueError:
            return NormalizedIndicator(indicator, value, "invalid IP address")
        documentation = allow_documentation_ranges and is_documentation_ip(ip)
        if not ip.is_global and not documentation:
            return NormalizedIndicator(
                indicator, str(ip), "non-public IP; not sent to external providers"
            )
        return NormalizedIndicator(indicator, str(ip))

    if indicator.type == "file_hash":
        lowered = value.lower()
        hash_type = _HASH_LENGTHS.get(len(lowered))
        if not hash_type or not _HEX.match(lowered):
            return NormalizedIndicator(indicator, lowered, "unrecognized hash format")
        return NormalizedIndicator(indicator, lowered, hash_type=hash_type)

    if indicator.type == "domain":
        lowered = value.lower().rstrip(".")
        if not _DOMAIN.match(lowered):
            return NormalizedIndicator(indicator, lowered, "invalid domain")
        return NormalizedIndicator(indicator, lowered)

    if indicator.type == "url":
        if not re.match(r"^https?://", value, flags=re.IGNORECASE):
            return NormalizedIndicator(indicator, value, "unsupported URL scheme")
        return NormalizedIndicator(indicator, value)

    return NormalizedIndicator(indicator, value, f"unsupported indicator type: {indicator.type}")
