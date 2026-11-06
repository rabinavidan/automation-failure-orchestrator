"""One attack, three SIEMs: vendor adapters only translate, the decision is the pipeline's.

The same credential brute force arriving as a Splunk webhook, a Sentinel alert and a Wazuh alert
must get the same triage outcome and the same response playbook. A vendor-specific difference
here means triage logic leaked into an adapter.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from support import alerts
from support.alerts import Json
from support.clients import IngestionClient

pytestmark = pytest.mark.soc

BRUTE_FORCE: dict[str, Callable[[], Json]] = {
    "splunk": lambda: alerts.splunk_brute_force(dest=alerts.host()),
    "sentinel": alerts.sentinel_brute_force,
    "wazuh": alerts.wazuh_ssh_brute_force,
}


@pytest.mark.parametrize("vendor", sorted(BRUTE_FORCE))
def test_brute_force_gets_the_same_decision_from_every_siem(
    ingestion: IngestionClient, vendor: str
) -> None:
    result = ingestion.post_alert(BRUTE_FORCE[vendor](), vendor).json()

    assert result["status"] == "new"
    triage = result["triage"]
    assert triage["disposition"] == "true_positive"
    assert triage["priority"] == "P1"
    assert "T1110" in triage["mitre"]["techniques"], "every vendor maps to ATT&CK brute force"
    assert result["response"]["playbooks"] == ["brute-force-response"]
