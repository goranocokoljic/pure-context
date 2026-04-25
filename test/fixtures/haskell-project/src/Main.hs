module Main where

import Data.List (sort, nub)
import qualified Data.Map as M
import Data.Maybe hiding (fromJust)

-- | Maximum number of retries.
maxRetries :: Int
maxRetries = 3

-- | Greet a user by name.
greet :: String -> String
greet name = "Hello, " ++ name ++ "!"

-- | Compute the factorial of a non-negative integer.
factorial :: Int -> Int
factorial 0 = 1
factorial n = n * factorial (n - 1)

-- | Apply a function twice.
applyTwice :: (a -> a) -> a -> a
applyTwice f x = f (f x)

-- | Reverse and deduplicate a list.
revUniq :: (Ord a) => [a] -> [a]
revUniq = reverse . nub . sort

-- Local helper - should NOT be extracted as top-level symbol
processItems :: [Int] -> [Int]
processItems xs = map transform xs
  where
    transform x = x * 2 + offset
    offset = 10
