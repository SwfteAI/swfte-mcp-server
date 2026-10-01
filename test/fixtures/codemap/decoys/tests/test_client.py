from unittest import mock


def test_invoke_is_mocked():
    client = mock.MagicMock()
    client.workflows.invoke("wf_8K2mQ4", {"sources": [], "topic": "t"})
    client.workflows.invoke.assert_called_once()
