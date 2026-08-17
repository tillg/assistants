/*
 * SPDX-License-Identifier: EUPL-1.2
 *
 * Copyright (c) 2026 Till Gartner
 *
 * Part of Assistants.
 *
 * Licensed under the European Union Public Licence, version 1.2 - see
 * https://eupl.eu/ and the LICENSE file at the root of this repository.
 * Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.
 */

package com.grtnr.assistants.server.bookkeeping;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Where the Runtime is, and what the client may ask it for.
 *
 * <p>The allowlist is deployment's half of the gate (ADR-0023). The Runtime holds the other half, in
 * code, and refuses anything mutating whatever this says — so a mistake here cannot open the write
 * path. It can only fail to open a read one.
 */
@ConfigurationProperties(prefix = "assistants.runtime")
public class RuntimeProperties {

    /** Reachable on the compose network only; the Runtime publishes nothing to the host. */
    private String url = "http://runtime:8090";

    /**
     * Not the User's authentication -- that already happened here, against Keycloak. This is what
     * stops any other container on the network calling the door outward.
     */
    private String sharedSecret = "";

    /** Operation keys an External Call may name. Empty admits nothing, which is the right default. */
    private List<String> allowedOperations = List.of();

    /** A human is waiting, so this is well under the Runtime connector's own twenty seconds. */
    private int timeoutMillis = 10_000;

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public String getSharedSecret() {
        return sharedSecret;
    }

    public void setSharedSecret(String sharedSecret) {
        this.sharedSecret = sharedSecret;
    }

    public List<String> getAllowedOperations() {
        return allowedOperations;
    }

    public void setAllowedOperations(List<String> allowedOperations) {
        this.allowedOperations = allowedOperations;
    }

    public int getTimeoutMillis() {
        return timeoutMillis;
    }

    public void setTimeoutMillis(int timeoutMillis) {
        this.timeoutMillis = timeoutMillis;
    }
}
