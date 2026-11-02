"""Zero-cost AWS path (docker-compose.aws-local.yml): API -> SQS (moto) -> investigation
worker -> persisted result -> message deleted. No AWS account, nothing billed."""

from __future__ import annotations

import re
import time
from typing import Any

import httpx
import pytest

from support import alerts
from support.clients import IngestionClient
from support.system import env, require_reachable

pytestmark = pytest.mark.system

SQS = env("AWS_ENDPOINT_URL", "http://localhost:4566")
QUEUE_BASE = f"{SQS}/123456789012"


# moto picks the emulated service from the SigV4 credential scope; it does not verify the
# signature. Without a scope, a POST to a queue URL is routed to its S3 emulation instead.
SQS_SCOPE = {
    "Authorization": (
        "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/sqs/aws4_request, "
        "SignedHeaders=host, Signature=0"
    )
}


def _depth(queue: str) -> tuple[int, int]:
    """(visible, in flight) through the SQS query API."""
    response = httpx.post(
        f"{SQS}/",
        data={
            "Action": "GetQueueAttributes",
            "QueueUrl": f"{QUEUE_BASE}/{queue}",
            "AttributeName.1": "ApproximateNumberOfMessages",
            "AttributeName.2": "ApproximateNumberOfMessagesNotVisible",
        },
        headers=SQS_SCOPE,
    ).raise_for_status()
    values = dict(re.findall(r"<Name>(\w+)</Name>\s*<Value>(\d+)</Value>", response.text))
    return int(values["ApproximateNumberOfMessages"]), int(
        values["ApproximateNumberOfMessagesNotVisible"]
    )


@pytest.fixture(scope="module")
def investigated(ingestion: IngestionClient) -> dict[str, Any]:
    require_reachable(SQS, "moto (AWS emulator)", "aws-local")
    body = ingestion.post_alert(alerts.splunk_brute_force(), "splunk").json()
    assert body["investigation"].get("queue") == "sqs", "investigation was not handed to SQS"
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        alert = ingestion.get_alert(body["alertId"])
        if alert["ai_investigation_status"] in {"completed", "failed"}:
            return alert
        time.sleep(2)
    pytest.fail("the worker did not finish the investigation within 90 s")


def test_worker_completes_the_queued_investigation(investigated: dict[str, Any]) -> None:
    assert investigated["ai_investigation_status"] == "completed"
    assert investigated["ai_investigation"]["graphVersion"] == "soc-supervisor-v1"
    assert investigated["ai_evaluation"]["passed"] is True, investigated["ai_evaluation"]


def test_message_is_deleted_and_nothing_reaches_the_dead_letter_queue(
    investigated: dict[str, Any],
) -> None:
    assert _depth("soc-investigations") == (0, 0)
    assert _depth("soc-investigations-dlq")[0] == 0
