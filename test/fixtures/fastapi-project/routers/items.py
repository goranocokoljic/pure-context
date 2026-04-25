from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
async def list_items():
    return {"items": []}


@router.get("/{item_id}/tags")
async def get_item_tags(item_id: int):
    """Get tags for an item — tests nested path param."""
    return {"item_id": item_id, "tags": []}


@router.post("/")
async def create_item():
    return {"created": True}
