package com.example.traits

/** Generic repository trait for CRUD operations.
  * @tparam A the entity type
  */
trait Repository[A] {
  def save(entity: A): Unit
  def findById(id: String): Option[A]
  def findAll(): List[A]
  def delete(id: String): Boolean
}

/** Trait for entities that can be audited. */
trait Auditable {
  def createdAt: Long
  def updatedAt: Long
}

/** Trait for named entities. */
trait Named {
  def name: String
  def displayName: String = name.capitalize
}

// Scala 3 given instance example
given defaultOrdering: Ordering[String] = Ordering.String

// Scala 3 extension methods
extension (s: String)
  def shout: String = s.toUpperCase + "!"
  def whisper: String = s.toLowerCase
