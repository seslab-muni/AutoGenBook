# From Calculating Machines to the Analytical Engine

Written for the AutoGenBook benchmark. Original text, released under the
repository's Apache 2.0 licence.

## Early calculating machines

The desire to mechanise arithmetic is old. In 1642 the French mathematician
Blaise Pascal built a machine that could add and subtract by means of
interlocking toothed wheels, one wheel for each decimal digit. When a wheel
passed from nine to zero it advanced its neighbour by one position, which
solved the problem of carrying automatically. Pascal built the machine to
help his father, a tax official, with long columns of figures.

In the 1670s Gottfried Wilhelm Leibniz designed a machine that could also
multiply and divide. Its central component, the stepped drum, is a cylinder
with teeth of increasing length. Depending on how far a gear was shifted
along the drum, it engaged a different number of teeth, so that a single
turn of the crank added a chosen digit. Variants of the stepped drum were
used in commercial calculators for more than two centuries.

## Punched cards and the Jacquard loom

A second line of development came from the textile industry. In 1804 Joseph
Marie Jacquard demonstrated a loom controlled by a chain of punched cards.
Each card corresponded to one row of the fabric, and the pattern of holes
determined which warp threads were lifted. Changing the cards changed the
pattern without rebuilding the machine. The Jacquard loom showed that a
sequence of instructions could be stored on an external medium and read by a
machine, an idea that would become central to computing.

## Babbage and the Difference Engine

In the early nineteenth century navigation, engineering and finance depended
on printed mathematical tables of logarithms and trigonometric functions.
These tables were computed by hand and contained many errors, some introduced
by the human computers and others by the typesetters. Charles Babbage, a
Cambridge mathematician, proposed in 1822 to compute and print such tables
mechanically.

His Difference Engine was based on the method of finite differences. For a
polynomial, the differences between successive values eventually become
constant, so every value of the table can be obtained from the previous ones
by addition alone. A machine that can add can therefore tabulate any
polynomial, and many other functions can be approximated by polynomials over
short intervals.

The British government funded the construction, but the project stopped in
1833 after disputes with the engineer Joseph Clement and rising costs. Only a
fraction of the machine was completed. In 1991 the Science Museum in London
completed a Difference Engine No. 2 built to Babbage's later design, and it
worked as he had intended, which showed that his designs were sound.

## The Analytical Engine

While working on the Difference Engine, Babbage conceived a far more general
machine, the Analytical Engine, which he described from 1834 onwards. It was
never built, but its design contained the main elements of a modern
computer.

The engine had two main parts. The store held numbers on columns of wheels,
and Babbage planned a capacity of about one thousand numbers of fifty digits
each. The mill performed arithmetic operations on numbers brought from the
store, in the way a processor works on values from memory. Instructions and
data were to be supplied on punched cards borrowed from the Jacquard loom:
operation cards specified what the mill should do, and variable cards
specified which columns of the store to use.

Crucially, the engine could make decisions. Depending on the result of a
calculation, for example whether a number was negative, it could skip
forward or backward in the sequence of cards. This conditional branching,
together with the ability to repeat a sequence of operations, made the
Analytical Engine a general-purpose machine rather than a calculator for a
single class of problems.

## Ada Lovelace and the first published program

In 1842 the Italian engineer Luigi Menabrea published a description of the
Analytical Engine in French, based on lectures Babbage gave in Turin. Ada
Lovelace, a mathematician and the daughter of the poet Lord Byron, translated
the article into English in 1843 and added a series of notes that were about
three times longer than the original text.

In the last of these notes, Note G, Lovelace described in detail how the
engine could compute the Bernoulli numbers, listing the sequence of
operations and the variables involved. This table is often described as the
first published computer program. Lovelace also understood that the engine
could manipulate symbols other than numbers. She suggested that it might
compose elaborate pieces of music if the relations between musical sounds
could be expressed in its notation, while insisting that the engine could
not originate anything by itself and could only do what it was ordered to
perform.

## The legacy of mechanical computing

Babbage's ideas had little direct influence on the builders of the first
electronic computers a century later, most of whom rediscovered the same
principles independently. Mechanical computing nevertheless advanced in
practice. Swedish printers Georg and Edvard Scheutz built a working
difference engine in 1853, inspired by Babbage's work.

At the end of the century, Herman Hollerith used punched cards for a
different purpose. For the 1890 United States census he built electric
tabulating machines that read cards by passing pins through the holes and
closing electrical circuits. The census was processed in a fraction of the
time needed for the previous one. Hollerith's company later became part of
the firm that was renamed International Business Machines (IBM) in 1924, and
punched cards remained the standard medium for data processing until the
1970s.
