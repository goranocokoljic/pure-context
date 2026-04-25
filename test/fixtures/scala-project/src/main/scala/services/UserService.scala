package com.example.services

import com.example.models.User
import com.example.traits.Repository

/** Service for managing users. */
class UserService extends Repository[User] {

  private val storage = scala.collection.mutable.Map.empty[String, User]

  /** Greet the user by name. */
  def greet(user: User): String =
    s"Hello, ${user.name}!"

  /** Save a user to the store. */
  def save(entity: User): Unit =
    storage(entity.name) = entity

  /** Find a user by name. */
  def findById(id: String): Option[User] =
    storage.get(id)

  /** List all stored users. */
  def findAll(): List[User] =
    storage.values.toList

  /** Delete a user. */
  def delete(id: String): Boolean =
    storage.remove(id).isDefined

  private def validate(user: User): Boolean =
    user.email.contains("@")
}

/** Generic container with type parameter. */
class Container[A](initial: A) {
  private var value: A = initial

  def get: A = value
  def set(newVal: A): Unit = value = newVal
}
