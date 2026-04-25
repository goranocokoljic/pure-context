module Types where

-- | A user in the system.
data User
  = User
      { userId   :: Int
      , userName :: String
      , userAge  :: Int
      }
  | GuestUser
      { guestId :: Int
      }

-- | A simple colour enumeration.
data Color = Red | Green | Blue

-- | Wrap a user identifier.
newtype UserId = UserId Int

-- | Human-readable name alias.
type Name = String

-- | Version string alias.
type Version = String
