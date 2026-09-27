from unittest import mock


def test_draft_weekly_invokes_pipeline():
    with mock.patch("acme_worker.tasks.client") as fake:
        fake.workflows.invoke.return_value.execution_id = "exec_1"
        from acme_worker.tasks import draft_weekly

        assert draft_weekly("x") == "exec_1"
        fake.workflows.invoke("wf_8K2mQ4", {"sources": [], "topic": "x"})
