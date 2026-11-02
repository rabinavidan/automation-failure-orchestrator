"""Builders for native SIEM payloads and the normalized SecurityAlert contract.

Mock threat intel (apps/enrichment-service, mock mode) is deterministic:
203.0.113.0/24 -> malicious, 198.51.100.0/24 -> suspicious, EICAR hashes -> malicious.
Triage policy (config/soc-triage-policy.json): 192.0.2.10 is an allowlisted scanner;
user svc_healthcheck on a brute-force rule is known-benign.

Every builder takes a unique host by default, so each test gets its own alert fingerprint.
"""

from __future__ import annotations

import uuid
from typing import Any

from .factories import unique

__all__ = ["unique"]

Json = dict[str, Any]

MALICIOUS_IP = "203.0.113.7"
SUSPICIOUS_IP = "198.51.100.23"
ALLOWLISTED_SCANNER_IP = "192.0.2.10"
EICAR_MD5 = "44d88612fea8a8f36de82e1278abb02f"


def host() -> str:
    return f"{unique('ws')}.corp.example.com"


def splunk_brute_force(
    *,
    src: str = MALICIOUS_IP,
    user: str = "CORP\\jdoe",
    dest: str | None = None,
    sid: str | None = None,
    urgency: str = "high",
) -> Json:
    """Splunk ES 'Brute Force Access Behavior Detected' webhook alert action."""
    return {
        "sid": sid or f"scheduler__admin__{uuid.uuid4().hex[:12]}",
        "search_name": "Access - Brute Force Access Behavior Detected - Rule",
        "app": "SplunkEnterpriseSecuritySuite",
        "results_link": "https://splunk.example.com/app/search/@go?sid=test",
        "result": {
            "_time": "1759500000.000",
            "signature": "Brute Force Access Behavior Detected",
            "src": src,
            "dest": dest or host(),
            "user": user,
            "count": "57",
            "urgency": urgency,
            "mitre_tactic": "Credential Access",
            "annotations.mitre_attack": ["T1110", "T1110.001"],
        },
    }


def splunk_malware(
    *, dest_host: str | None = None, sid: str | None = None, user: str | None = None
) -> Json:
    """Splunk ES endpoint malware detection: EICAR hash, process and a C2 source IP."""
    return {
        "sid": sid or f"scheduler__admin__{uuid.uuid4().hex[:12]}",
        "search_name": "Endpoint - Malware Detected - Rule",
        "app": "SplunkEnterpriseSecuritySuite",
        "result": {
            "_time": "2026-10-03T14:05:00Z",
            "signature": "Trojan.GenericKD detected",
            "src": "203.0.113.66",
            "dest_host": dest_host or unique("srv"),
            "user": user or f"{unique('user')}@corp.example.com",
            "file_hash": EICAR_MD5,
            "process_name": "invoice.exe",
            "severity": "5",
            "mitre_technique_id": "T1204.002",
        },
    }


def sentinel_brute_force(*, host_name: str | None = None) -> Json:
    """Sentinel analytic rule alert as posted by a Logic App (Entities as a JSON string)."""
    import json

    return {
        "SystemAlertId": str(uuid.uuid4()),
        "AlertDisplayName": "Brute force attack against Azure AD account",
        "AlertType": "brute_force",
        "Severity": "High",
        "Description": "Multiple failed sign-ins followed by lockout",
        "ProductName": "Azure Sentinel",
        "StartTimeUtc": "2026-10-03T12:00:00Z",
        "Tactics": "CredentialAccess, InitialAccess",
        "Techniques": '["T1110","T1110.003"]',
        "Entities": json.dumps(
            [
                {"$id": "2", "Type": "account", "Name": "jdoe", "UPNSuffix": "corp.example.com"},
                {"$id": "3", "Type": "ip", "Address": "203.0.113.21"},
                {"$id": "4", "Type": "host", "HostName": host_name or unique("ws")},
            ]
        ),
    }


def wazuh_ssh_brute_force(*, agent_name: str | None = None) -> Json:
    """Wazuh sshd brute-force rule 5712 via a custom integration."""
    return {
        "id": f"{uuid.uuid4().int % 10**10}.123456",
        "timestamp": "2026-10-03T12:00:00.000+0000",
        "rule": {
            "id": "5712",
            "level": 10,
            "description": "sshd: brute force trying to get access to the system.",
            "groups": ["syslog", "sshd", "authentication_failures"],
            "mitre": {"id": ["T1110"], "tactic": ["Credential Access"]},
        },
        "agent": {"id": "003", "name": agent_name or unique("web"), "ip": "10.0.1.20"},
        "data": {"srcip": "203.0.113.22", "dstuser": "root"},
    }


def security_alert(**overrides: Any) -> Json:
    """An alert already in the normalized SecurityAlert contract (POST /api/alerts)."""
    alert: Json = {
        "schemaVersion": "1.0.0",
        "alertId": f"generic:{uuid.uuid4()}",
        "source": {"vendor": "generic", "product": "pytest"},
        "ruleId": "Suspicious outbound connection",
        "ruleName": "Suspicious outbound connection",
        "title": "Workstation contacted a low-volume scanner",
        "severity": "medium",
        "detectedAt": "2026-10-03T12:00:00Z",
        "host": host(),
        "user": "jdoe",
        "indicators": [{"type": "ip", "value": SUSPICIOUS_IP, "role": "destination"}],
    }
    alert.update(overrides)
    return alert
