library(stats)
require(utils)

#' Greet a user by name.
#'
#' @param name A character string with the user's name.
#' @return A greeting string.
greet <- function(name) {
  paste0("Hello, ", name, "!")
}

#' Compute the square of a number.
#'
#' @param x Numeric value.
#' @return The square of x.
square <- function(x) x^2

# Function using = assignment
normalize = function(x, center = TRUE) {
  if (center) x - mean(x) else x / max(x)
}

# Right-assignment (rare but valid)
function(x, y) x + y -> add

# S3 method for print
print.myclass <- function(x, ...) {
  cat("myclass:", x$value, "\n")
  invisible(x)
}

# S3 method for summary
summary.myclass <- function(object, ...) {
  cat("Summary of myclass\n")
}

# Top-level constant
MAX_RETRIES <- 5
DEFAULT_TIMEOUT <- 30L

# Nested function should NOT be extracted
outer <- function(x) {
  inner <- function(y) y * 2
  inner(x)
}
