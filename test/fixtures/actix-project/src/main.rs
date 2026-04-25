use actix_web::{delete, get, patch, post, put, web, App, HttpResponse, HttpServer, Responder};
use actix_web::dev::{forward_ready, Service, ServiceRequest, ServiceResponse, Transform};

// ─── Handlers ─────────────────────────────────────────────────────────────────

async fn list_items() -> impl Responder { HttpResponse::Ok().finish() }
async fn create_item() -> impl Responder { HttpResponse::Created().finish() }
async fn status() -> impl Responder { HttpResponse::Ok().finish() }

// ─── Attribute macro routes ────────────────────────────────────────────────────

#[get("/health")]
async fn health_check() -> impl Responder {
    HttpResponse::Ok().body("ok")
}

#[get("/users")]
async fn list_users() -> impl Responder {
    HttpResponse::Ok().json(Vec::<String>::new())
}

#[post("/users")]
async fn create_user(body: web::Json<serde_json::Value>) -> impl Responder {
    HttpResponse::Created().finish()
}

#[get("/users/{id}")]
async fn get_user(path: web::Path<u64>) -> impl Responder {
    HttpResponse::Ok().finish()
}

#[put("/users/{id}")]
async fn update_user(path: web::Path<u64>) -> impl Responder {
    HttpResponse::Ok().finish()
}

#[delete("/users/{id}")]
async fn delete_user(path: web::Path<u64>) -> impl Responder {
    HttpResponse::NoContent().finish()
}

#[patch("/users/{id}")]
async fn patch_user(path: web::Path<u64>) -> impl Responder {
    HttpResponse::Ok().finish()
}

// ─── Extractor ────────────────────────────────────────────────────────────────

struct AuthUser {
    user_id: u64,
}

impl actix_web::FromRequest for AuthUser {
    type Error = actix_web::Error;
    type Future = std::future::Ready<Result<Self, Self::Error>>;

    fn from_request(
        req: &actix_web::HttpRequest,
        _payload: &mut actix_web::dev::Payload,
    ) -> Self::Future {
        std::future::ready(Ok(AuthUser { user_id: 1 }))
    }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

struct AuthMiddleware;

// ─── Main ─────────────────────────────────────────────────────────────────────

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            // Attribute macro routes registered as services
            .service(health_check)
            .service(list_users)
            .service(create_user)
            .service(get_user)
            .service(update_user)
            .service(delete_user)
            .service(patch_user)
            // Programmatic resource routes
            .service(
                web::resource("/items")
                    .route(web::get().to(list_items))
                    .route(web::post().to(create_item))
            )
            // Scope with nested resource
            .service(
                web::scope("/api/v2")
                    .service(web::resource("/status").route(web::get().to(status)))
            )
            // Middleware
            .wrap(actix_web::middleware::Logger::default())
            .wrap(AuthMiddleware)
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
