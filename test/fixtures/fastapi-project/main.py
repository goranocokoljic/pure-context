from fastapi import FastAPI, Depends
from routers.users import router as users_router
from routers.items import router as items_router

app = FastAPI(title="Example API")

app.include_router(users_router)
app.include_router(items_router)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"message": "Hello World"}


def plain_helper():
    """Not a route — should not be extracted."""
    pass
