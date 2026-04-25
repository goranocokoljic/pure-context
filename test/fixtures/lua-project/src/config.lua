-- Application configuration constants.
local Config = {
    version    = "1.0.0",
    maxRetries = 3,
    timeout    = 30,
    logLevel   = "info",
}

-- Database connection defaults.
local DbDefaults = {
    host    = "localhost",
    port    = 5432,
    name    = "app_db",
    poolMin = 2,
    poolMax = 10,
}

-- HTTP client settings.
local HttpSettings = {
    baseUrl     = "https://api.example.com",
    userAgent   = "MyApp/1.0",
    maxRedirect = 5,
}

return Config
