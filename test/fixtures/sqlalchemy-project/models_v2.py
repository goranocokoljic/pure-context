"""SQLAlchemy 2.0 style models (Mapped / mapped_column)."""

from __future__ import annotations

from typing import Optional, List
from sqlalchemy import String, Integer, ForeignKey, Numeric, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    products: Mapped[List["Product2"]] = relationship(back_populates="category")


class Product2(Base):
    __tablename__ = "products_v2"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    price: Mapped[float] = mapped_column(nullable=False)
    category_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("categories.id"), nullable=True
    )

    category: Mapped[Optional["Category"]] = relationship(
        "Category", back_populates="products"
    )
