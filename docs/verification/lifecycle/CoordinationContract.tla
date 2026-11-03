---------------------- MODULE CoordinationContract ----------------------
EXTENDS Naturals, FiniteSets

Owners(a) == {i \in DOMAIN a : a[i].live /\ a[i].pc = "inside"}
Exclusive(a) == Cardinality(Owners(a)) <= 1
RetainsClaim(a, claim) == \A i \in Owners(a) : claim[i]
=============================================================================
