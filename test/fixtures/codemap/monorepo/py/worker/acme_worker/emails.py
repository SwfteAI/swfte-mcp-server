"""HTML fragments for transactional emails and the status page."""
from jinja2 import Environment, PackageLoader

from acme_worker.settings import settings

env = Environment(loader=PackageLoader("acme_worker"), autoescape=True)

SUPPORT_IFRAME = '<iframe src="https://app.swfte.com/chat/ag_Docs2W" title="Docs assistant" width="400" height="600"></iframe>'


def status_page() -> str:
    return env.get_template("help.html").render(agent_id=settings.help_agent_id, support_iframe=SUPPORT_IFRAME)
