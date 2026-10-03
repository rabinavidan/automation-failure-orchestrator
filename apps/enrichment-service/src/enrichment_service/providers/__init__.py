"""Threat-intel providers. Live and mock implementations share one interface."""

from .base import Provider, verdict_from_score

__all__ = ["Provider", "verdict_from_score"]
