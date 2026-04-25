use axum::{
    extract::FromRequest,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

// ─── Handlers ─────────────────────────────────────────────────────────────────

async fn health_check() -> &'static str { "ok" }
async fn list_users() -> &'static str { "[]" }
async fn create_user() -> &'static str { "created" }
async fn get_user() -> &'static str { "user" }
async fn update_user() -> &'static str { "updated" }
async fn delete_user() -> &'static str { "deleted" }
async fn list_items() -> &'static str { "[]" }
async fn get_item() -> &'static str { "item" }

// ─── Extractors ───────────────────────────────────────────────────────────────

/// Extractor via derive macro
#[derive(FromRequest)]
#[from_request(via(axum::Json))]
struct CreateUserPayload {
    name: String,
    email: String,
}

/// Extractor via manual impl
struct AuthUser {
    user_id: u64,
}

impl<S> FromRequest<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = ();

    async fn from_request(
        _req: axum::extract::Request,
        _state: &S,
    ) -> Result<Self, ()> {
        Ok(AuthUser { user_id: 1 })
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Sub-router for user endpoints
    let user_routes = Router::new()
        .route("/", get(list_users).post(create_user))
        .route("/:id", get(get_user).put(update_user).delete(delete_user));

    // Sub-router for item endpoints
    let item_routes = Router::new()
        .route("/", get(list_items))
        .route("/:id", get(get_item));

    // Main application router
    let app = Router::new()
        .route("/health", get(health_check))
        .nest("/users", user_routes)
        .nest("/items", item_routes)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    axum::serve(
        tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap(),
        app,
    )
    .await
    .unwrap();
}
