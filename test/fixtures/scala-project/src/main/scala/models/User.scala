package com.example.models

/** Represents a user in the system.
  *
  * @param name  The user's display name.
  * @param age   The user's age in years.
  * @param email The user's email address.
  */
case class User(name: String, age: Int, email: String)

/** Admin user with elevated privileges. */
case class Admin(name: String, permissions: List[String]) extends User(name, 0, "")

/** Immutable address record. */
case class Address(
  street: String,
  city: String,
  country: String = "US",
)

/** User status enumeration (Scala 3). */
enum UserStatus:
  case Active, Inactive, Suspended

/** Companion object for User. */
object User {
  /** Create a guest user with default values. */
  def guest(): User = User("guest", 0, "")

  val DefaultAge: Int = 18
}

/** Type aliases. */
type UserId = String
type UserMap = Map[UserId, User]
