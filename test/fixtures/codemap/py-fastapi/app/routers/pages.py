from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.settings import settings

router = APIRouter(tags=["pages"])
templates = Jinja2Templates(directory="templates")


@router.get("/account", response_class=HTMLResponse)
def account(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "account.html",
        {"support_agent": settings.support_agent_id, "portal_agent": settings.portal_agent_id, "theme": "auto"},
    )


@router.get("/portal", response_class=HTMLResponse)
def portal(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "portal.html", {"user": request.state.user})
