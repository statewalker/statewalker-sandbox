# PeerShare glossary

**Sharer** — the person who opens the PeerShare page and publishes Services. Has a
display name ("Dirk") and one stable identity per browser. The Sharer's tab is the
whole server side: it is the Hub of the Sharer's own mesh.

**Guest** — a person invited by the Sharer. Joins the Sharer's mesh through an Invite
and can only view the Sharer's Services. Cannot invite anyone.

**Service** — one local HTTP service the Sharer publishes: a name, a local URL, an
on/off state, and whether it is the Default Service.

**Default Service** — the Service a Guest sees first after joining.

**Upstream** — how the Sharer's tab reaches a Service's local URL. Two kinds:
*Direct* (the service itself allows cross-origin calls from the PeerShare page) and
*Bridged* (through the Bridge).

**Bridge** — the small downloadable program that runs on the Sharer's machine,
listens on loopback, and relays the PeerShare page's requests to local Services with
the cross-origin permission the page needs. It is not a member of any mesh.

**Pairing token** — the random secret the Bridge prints at launch and hands to the
PeerShare page; the Bridge answers nobody without it.

**Invite** — a link (and the same link as a QR code) that admits one Guest, once,
within 24 hours, to all the Sharer's Services.

**Viewer** — what a Guest sees after joining: the bar "SandClaw.ai presents: *Sharer*
[Close session]" over the Service, which runs in its own isolated origin.

**Probe** — the "Test again" check of one Service: reachable, how fast, and what will
not work for Guests (cross-origin permission missing, WebSockets needed, cookies set).

**Health** — the Probe's verdict: ok, slow, down, disabled, checking.

**Pause** — turning one Service off. Guests stay members and see that it is paused.

**Stop** — turning the whole server off ("Turn off server"). Guests see the Sharer as
offline and come back automatically when the Sharer returns.

**Revoke** — removing one Guest for good.

**Close session** — a Guest leaving for good: their identity is forgotten, so coming
back needs a new Invite. Closing the tab is not Close session.
