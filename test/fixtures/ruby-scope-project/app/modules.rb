module MyPlugin
  module ClassMethods
    register :handler
    register :formatter
  end

  module OtherMethods
    register :helper
  end
end
