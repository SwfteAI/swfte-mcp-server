package com.acme.billing;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.swfte.sdk.SwfteClient;
import java.util.Map;
import org.junit.jupiter.api.Test;

class BillingJobsTest {
    @Test
    void chargeUsesInvoiceTriage() {
        SwfteClient client = mock(SwfteClient.class, org.mockito.Mockito.RETURNS_DEEP_STUBS);
        when(client.workflows().invoke("wf_Inv7Tr2", Map.of("invoiceUrl", "u", "vendor", "v"))).thenReturn(null);
    }
}
