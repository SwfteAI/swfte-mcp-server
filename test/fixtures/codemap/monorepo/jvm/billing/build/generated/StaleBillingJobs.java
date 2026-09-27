// Stale annotation-processor output left in build/ (never compiled from here).
package com.acme.billing;

public class StaleBillingJobs {
    public Object run(com.swfte.sdk.SwfteClient client) {
        return client.workflows().invoke("wf_Inv7Tr2", java.util.Map.of("invoiceUrl", "x", "vendor", "y"));
    }
}
