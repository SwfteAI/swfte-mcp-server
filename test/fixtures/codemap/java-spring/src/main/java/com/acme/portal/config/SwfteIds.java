package com.acme.portal.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Artifact ids that differ per deployment; set through application.yml / the environment. */
@Component
public class SwfteIds {

    @Value("${swfte.ids.billing-workflow}")
    private String billingWorkflow;

    @Value("${swfte.ids.escalation-agent}")
    private String escalationAgent;

    public String getBillingWorkflow() {
        return billingWorkflow;
    }

    public String getEscalationAgent() {
        return escalationAgent;
    }
}
