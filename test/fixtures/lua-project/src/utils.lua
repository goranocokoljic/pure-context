local string_utils = require("utils.string")

-- Trim whitespace from both ends of a string.
function trim(s)
    return s:match("^%s*(.-)%s*$")
end

-- Convert a string to lowercase.
function toLower(s)
    return string.lower(s)
end

-- Split a string by a separator.
function split(s, sep)
    local result = {}
    for part in s:gmatch("[^" .. sep .. "]+") do
        result[#result + 1] = part
    end
    return result
end

-- Join a list of strings with a separator.
function join(parts, sep)
    return table.concat(parts, sep)
end

-- Internal helper: validate string is non-empty.
local function isNonEmpty(s)
    return s ~= nil and #s > 0
end

-- Format a key-value pair as a string.
local function formatPair(k, v)
    return k .. "=" .. tostring(v)
end
