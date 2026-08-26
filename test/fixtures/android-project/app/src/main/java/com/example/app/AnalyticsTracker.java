package com.example.app;

import com.example.core.AppDatabase;
import javax.inject.Inject;
import javax.inject.Singleton;

@Singleton
public class AnalyticsTracker {

    private final AppDatabase database;

    @Inject
    public AnalyticsTracker(AppDatabase database) {
        this.database = database;
    }

    public void trackEvent(String name) {
        database.insertEvent(name);
    }
}
