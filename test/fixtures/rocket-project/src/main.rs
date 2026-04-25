#[macro_use]
extern crate rocket;

use rocket::{Request, State};
use rocket::fairing::{Fairing, Info, Kind};
use rocket::http::Status;
use rocket::response::status::NotFound;
use serde::{Deserialize, Serialize};

// ─── Forms & Guards ────────────────────────────────────────────────────────────

#[derive(FromForm, Serialize, Deserialize, Debug)]
pub struct NewUser {
    pub name: String,
    pub email: String,
}

#[derive(FromRequest, Debug)]
pub struct ApiKey(String);

// ─── Simple macro routes ───────────────────────────────────────────────────────

#[get("/health")]
fn health_check() -> &'static str {
    "ok"
}

#[get("/users")]
fn list_users() -> &'static str {
    "[]"
}

#[post("/users", data = "<form>")]
fn create_user(form: rocket::form::Form<NewUser>) -> Status {
    Status::Created
}

#[get("/users/<id>")]
fn get_user(id: u64) -> String {
    format!("user {}", id)
}

#[put("/users/<id>", data = "<form>")]
fn update_user(id: u64, form: rocket::form::Form<NewUser>) -> Status {
    Status::Ok
}

#[delete("/users/<id>")]
fn delete_user(id: u64) -> Status {
    Status::NoContent
}

#[patch("/users/<id>")]
fn patch_user(id: u64) -> Status {
    Status::Ok
}

// ─── Generic #[route] macro ────────────────────────────────────────────────────

#[route(GET, path = "/v2/items")]
fn list_items_v2() -> &'static str {
    "[]"
}

#[route(POST, path = "/v2/items")]
fn create_item_v2() -> Status {
    Status::Created
}

// ─── Error catchers ────────────────────────────────────────────────────────────

#[catch(404)]
fn not_found(req: &Request) -> String {
    format!("Sorry, '{}' is not a valid path.", req.uri())
}

#[catch(500)]
fn internal_error() -> &'static str {
    "Internal server error"
}

#[catch(default)]
fn default_catcher(status: Status, req: &Request) -> String {
    format!("Error {}: {}", status.code, req.uri())
}

// ─── Fairing (middleware) ──────────────────────────────────────────────────────

pub struct LogFairing;

impl Fairing for LogFairing {
    fn info(&self) -> Info {
        Info {
            name: "Request Logger",
            kind: Kind::Request | Kind::Response,
        }
    }
}

pub struct AuthFairing;

impl rocket::fairing::Fairing for AuthFairing {
    fn info(&self) -> rocket::fairing::Info {
        rocket::fairing::Info {
            name: "Auth Checker",
            kind: rocket::fairing::Kind::Request,
        }
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

#[launch]
fn rocket() -> _ {
    rocket::build()
        .attach(LogFairing)
        .attach(AuthFairing)
        .register("/", catchers![not_found, internal_error, default_catcher])
        .mount("/", routes![
            health_check,
            list_users,
            create_user,
            get_user,
            update_user,
            delete_user,
            patch_user,
            list_items_v2,
            create_item_v2,
        ])
}
