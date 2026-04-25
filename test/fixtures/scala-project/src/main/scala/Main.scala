package com.example

import scala.collection.mutable.ListBuffer
import scala.util.{ Try, Success, Failure }

/** Entry point for the application. */
object Main {
  def main(args: Array[String]): Unit = {
    val service = new UserService()
    val user = User("alice", 30, "alice@example.com")
    println(service.greet(user))
  }

  /** Parse command-line arguments. */
  def parseArgs(args: Array[String]): Map[String, String] = {
    args.sliding(2, 2).collect { case Array(k, v) => k -> v }.toMap
  }
}

/** Utility functions. */
object Utils {
  val Version: String = "1.0.0"

  def formatName(first: String, last: String): String =
    s"$first $last"

  private def internalHelper(x: Int): Int = x * 2
}
