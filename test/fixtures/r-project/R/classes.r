library(methods)

# S4 class definition
setClass("Person", representation(
  name = "character",
  age  = "numeric"
))

setClass("Employee", contains = "Person", representation(
  company = "character"
))

# S4 generic and method
setGeneric("greetPerson", function(person, ...) standardGeneric("greetPerson"))

setMethod("greetPerson", "Person", function(person, ...) {
  cat("Hello,", person@name, "\n")
})

setMethod("greetPerson", "Employee", function(person, ...) {
  cat("Hello,", person@name, "from", person@company, "\n")
})

# S4 show method
setMethod("show", "Person", function(object) {
  cat("Person:", object@name, "age", object@age, "\n")
})

# S3 constructor pattern
new_myclass <- function(value) {
  structure(list(value = value), class = "myclass")
}
