from fastapi import APIRouter, Depends

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/")
async def list_users():
    """List all users."""
    return {"users": []}


@router.get("/{user_id}")
async def get_user(user_id: int):
    """Get a single user by ID."""
    return {"id": user_id}


@router.post("/")
async def create_user():
    """Create a new user."""
    return {"created": True}


@router.put("/{user_id}")
async def update_user(user_id: int):
    return {"updated": user_id}


@router.delete("/{user_id}")
async def delete_user(user_id: int):
    return {"deleted": user_id}


@router.patch("/{user_id}")
async def patch_user(user_id: int):
    return {"patched": user_id}
