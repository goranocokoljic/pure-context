"""SQLAlchemy 1.x style models (declarative Base)."""

from sqlalchemy import (
    Column, Integer, String, Boolean, Text, DateTime,
    ForeignKey, Numeric, BigInteger, Float
)
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.ext.hybrid import hybrid_property

Base = declarative_base()


class User(Base):
    """User account model."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(50), nullable=False)
    email = Column(String(100), nullable=False)
    bio = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False)
    score = Column(Float, nullable=True)

    orders = relationship("Order", back_populates="user")
    profile = relationship("UserProfile", back_populates="user")

    @hybrid_property
    def display_name(self):
        return self.username.title()


class Order(Base):
    """Customer order model."""

    __tablename__ = "orders"

    id = Column(Integer, primary_key=True)
    total = Column(Numeric(10, 2), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    user = relationship("User", back_populates="orders")
    items = relationship("OrderItem", back_populates="order")


class UserProfile(Base):
    """Extended profile for a user."""

    __tablename__ = "user_profiles"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    full_name = Column(String(200), nullable=True)
    age = Column(Integer, nullable=True)

    user = relationship("User", back_populates="profile")


class Product(Base):
    # No explicit __tablename__ — should default to 'product'
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    price = Column(Numeric, nullable=False)
    description = Column(Text, nullable=True)
    in_stock = Column(Boolean, nullable=False)
