from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter
from pydantic import BaseModel

from app.swfte_clients.contract_review import invoke_contract_review

router = APIRouter(prefix="/contracts", tags=["contracts"])


class ReviewIn(BaseModel):
    url: str
    jurisdiction: str = "US-DE"


@router.post("/review")
def review_contract(body: ReviewIn) -> Dict[str, List[Any]]:
    res = invoke_contract_review({"documentUrl": body.url, "jurisdiction": body.jurisdiction})
    return {"clauses": res["output"]["clauses"]}
