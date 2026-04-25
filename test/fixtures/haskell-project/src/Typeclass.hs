module Typeclass where

import Types (User(..), Color(..))

-- | Things that can be pretty-printed.
class Printable a where
  -- | Render the value as a human-readable string.
  prettyPrint :: a -> String

-- | Things that can be serialised to JSON text.
class Serialisable a where
  toJson   :: a -> String
  fromJson :: String -> Maybe a

instance Printable User where
  prettyPrint (User i n _) = show i ++ ": " ++ n
  prettyPrint (GuestUser i) = "guest:" ++ show i

instance Printable Color where
  prettyPrint Red   = "red"
  prettyPrint Green = "green"
  prettyPrint Blue  = "blue"

instance Serialisable Color where
  toJson Red   = "\"red\""
  toJson Green = "\"green\""
  toJson Blue  = "\"blue\""
  fromJson "\"red\""   = Just Red
  fromJson "\"green\"" = Just Green
  fromJson "\"blue\""  = Just Blue
  fromJson _           = Nothing
