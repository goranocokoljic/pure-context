# Represents an application user.
class User < ApplicationRecord
  has_many :posts
  has_one :profile
  belongs_to :organization

  validates :email, presence: true

  private

  def encrypt_password
    # noop
  end
end
