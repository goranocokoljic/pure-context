class CleanupJob < ActiveJob::Base
  queue_as :low_priority

  def perform
    # cleanup logic
  end
end
