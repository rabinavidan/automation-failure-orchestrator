import pytest

from enrichment_service.iocs import normalize, refang
from enrichment_service.models import Indicator


def ind(type_: str, value: str) -> Indicator:
    return Indicator.model_validate({"type": type_, "value": value})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("hxxp://evil[.]example[.]net/payload", "http://evil.example.net/payload"),
        ("hXXps://bad(.)example.net", "https://bad.example.net"),
        ("203.0.113[.]7", "203.0.113.7"),
        ("  clean.example.com ", "clean.example.com"),
    ],
)
def test_refang(raw: str, expected: str) -> None:
    assert refang(raw) == expected


@pytest.mark.parametrize("ip", ["10.0.0.5", "192.168.1.10", "127.0.0.1", "169.254.1.1", "fd00::1"])
def test_private_ips_never_leave_the_network(ip: str) -> None:
    result = normalize(ind("ip", ip))
    assert not result.eligible
    assert result.skipped_reason is not None
    assert "not sent to external providers" in result.skipped_reason


def test_public_ip_is_eligible() -> None:
    assert normalize(ind("ip", "8.8.8.8")).eligible


def test_documentation_ranges_only_allowed_when_requested() -> None:
    assert not normalize(ind("ip", "203.0.113.7")).eligible
    assert normalize(ind("ip", "203.0.113.7"), allow_documentation_ranges=True).eligible
    assert normalize(ind("ip", "2001:db8::1"), allow_documentation_ranges=True).eligible
    # Real private space stays blocked even in mock mode.
    assert not normalize(ind("ip", "10.1.2.3"), allow_documentation_ranges=True).eligible


def test_invalid_ip() -> None:
    assert normalize(ind("ip", "999.1.1.1")).skipped_reason == "invalid IP address"


@pytest.mark.parametrize(
    ("value", "hash_type"),
    [
        ("44D88612FEA8A8F36DE82E1278ABB02F", "md5"),
        ("3395856ce81f2b7382dee72602f798b642f14140", "sha1"),
        ("275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f", "sha256"),
    ],
)
def test_hash_detection(value: str, hash_type: str) -> None:
    result = normalize(ind("file_hash", value))
    assert result.eligible
    assert result.hash_type == hash_type
    assert result.value == value.lower()


def test_bad_hash_rejected() -> None:
    assert not normalize(ind("file_hash", "xyz123")).eligible


@pytest.mark.parametrize("type_", ["user", "host", "process", "email"])
def test_internal_identity_is_never_sent_out(type_: str) -> None:
    assert not normalize(ind(type_, "CORP\\jdoe")).eligible


def test_domain_and_url_validation() -> None:
    assert normalize(ind("domain", "Evil.Example.NET.")).value == "evil.example.net"
    assert not normalize(ind("domain", "not a domain")).eligible
    assert normalize(ind("url", "https://x.example.net/a")).eligible
    assert not normalize(ind("url", "ftp://x.example.net/a")).eligible
