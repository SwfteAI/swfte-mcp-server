from __future__ import annotations

from celery import Celery

from app.settings import settings

celery_app = Celery("acme_ops", broker=settings.broker_url)
celery_app.conf.beat_schedule = {
    "weekly-report": {"task": "reports.weekly", "schedule": 7 * 24 * 3600},
    "sync-invoices": {"task": "invoices.sync", "schedule": 3600},
}
