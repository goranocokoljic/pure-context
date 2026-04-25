#' Format a date value as ISO 8601 string.
#'
#' @param date A Date or POSIXct object.
#' @param tz Time zone string (default "UTC").
#' @return A character string.
format_date <- function(date, tz = "UTC") {
  format(date, "%Y-%m-%dT%H:%M:%SZ", tz = tz)
}

#' Truncate a string to a maximum length.
#'
#' @param s Input string.
#' @param max Maximum number of characters (default 100).
#' @return Truncated string with ellipsis appended if needed.
truncate_string <- function(s, max = 100) {
  if (nchar(s) <= max) s else paste0(substr(s, 1, max - 3), "...")
}

#' Check whether a value is a non-empty string.
#'
#' @param x Any R object.
#' @return Logical TRUE if x is a non-empty character string.
is_nonempty_string <- function(x) {
  is.character(x) && length(x) == 1 && nchar(x) > 0
}

# Internal helper — no Roxygen2 doc
.pad_left <- function(s, width) {
  formatC(s, width = width, flag = " ")
}
