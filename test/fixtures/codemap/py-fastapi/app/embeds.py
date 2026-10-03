"""HTML snippets for pages that are not rendered through Jinja (emails, the status page)."""
from __future__ import annotations

WIDGET_SCRIPT = "https://unpkg.com/@swfte/chat-widget@1.4.0/dist/swfte-chat.umd.js"

HELPDESK_WIDGET = """
<script src="https://unpkg.com/@swfte/chat-widget@1.4.0/dist/swfte-chat.umd.js"></script>
<script>
  new SwfteChatWidget({ agentId: "ag_Help4Py", type: "bubble", position: "bottom-right" }).mount();
</script>
"""


def portal_iframe() -> str:
    return '<iframe src="https://app.swfte.com/chat/ag_Portal7" title="Acme portal assistant" width="400" height="600"></iframe>'


def sales_widget(theme: str = "light") -> str:
    return f"""
<script src="{WIDGET_SCRIPT}"></script>
<script>
  new SwfteChatWidget({{ agentId: "ag_Sales6", theme: "{theme}" }}).mount();
</script>
"""


def iframe_for(agent_ref: str) -> str:
    return f'<iframe src="https://app.swfte.com/chat/{agent_ref}" title="Assistant" width="400" height="600"></iframe>'
