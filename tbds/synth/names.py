"""Synthetic name pools by community (Assam) and spelling-variant generator for duplicate injection.

Names are generic and combined at random; they do not represent any real individuals.
"""
from __future__ import annotations

import numpy as np

COMMUNITIES = ["assamese", "bengali", "muslim", "tea_tribe", "bodo", "karbi_dimasa", "nepali", "other"]

FIRST_NAMES = {
    "assamese": {"M": ["Rupam", "Bhaskar", "Dipak", "Pranjal", "Nabajyoti", "Jitu", "Hemanta", "Kamal", "Manoj", "Biju", "Pulak", "Ranjit"],
                 "F": ["Dipika", "Mamoni", "Bornali", "Junali", "Rima", "Pranita", "Nilima", "Anjali", "Bina", "Ruma", "Madhabi", "Gitanjali"]},
    "bengali": {"M": ["Subrata", "Tapan", "Amit", "Biswajit", "Pradip", "Sanjib", "Gautam", "Ashok", "Dilip", "Nirmal", "Kajal", "Ratan"],
                "F": ["Rina", "Sumitra", "Kabita", "Mitali", "Shila", "Anita", "Purnima", "Rekha", "Sathi", "Mamata", "Gita", "Lipika"]},
    "muslim": {"M": ["Abdul", "Mohammad", "Rafiqul", "Nurul", "Sahidul", "Jahirul", "Anowar", "Mizanur", "Habibur", "Kutubuddin", "Samsul", "Fazlul"],
               "F": ["Rubina", "Samsun", "Jahanara", "Nasima", "Rokeya", "Sufia", "Anjuma", "Khaleda", "Mazida", "Hasina", "Rahima", "Salma"]},
    "tea_tribe": {"M": ["Budhua", "Sukra", "Mangal", "Ramesh", "Bikram", "Dhaneswar", "Sanjay", "Birsa", "Rabi", "Jaggu", "Pabitra", "Somra"],
                  "F": ["Phulmani", "Sukumari", "Budhni", "Mangri", "Lakhi", "Santoshi", "Rukmini", "Somari", "Kamli", "Dulari", "Chandni", "Basanti"]},
    "bodo": {"M": ["Mwnsri", "Jwngma", "Dwhwrw", "Gwlwi", "Bijit", "Hargobinda", "Naren", "Rajen", "Sansuma", "Bidyut", "Khanindra", "Lakhi"],
             "F": ["Gitali", "Phuleswari", "Anju", "Mili", "Jwhwlao", "Sewali", "Nirmala", "Bandana", "Sangita", "Rinku", "Maya", "Hasina"]},
    "karbi_dimasa": {"M": ["Jonthe", "Holiram", "Sing", "Dhaniram", "Kasin", "Bidyasing", "Rongsopi", "Nilmoni", "Dilip", "Jayanta", "Longki", "Robin"],
                     "F": ["Rongpi", "Jonali", "Mina", "Sarita", "Nirmali", "Bishali", "Anjana", "Rina", "Pushpa", "Lakshmi", "Kumari", "Mayuri"]},
    "nepali": {"M": ["Bishnu", "Dil", "Prem", "Krishna", "Ganesh", "Hari", "Narendra", "Suman", "Tilak", "Dambar", "Rajesh", "Bhim"],
               "F": ["Sita", "Kamala", "Laxmi", "Maya", "Sarita", "Gita", "Anita", "Radha", "Puja", "Sabitri", "Bimala", "Devi"]},
    "other": {"M": ["Rajesh", "Sunil", "Vijay", "Ramesh", "Anil", "Mukesh", "Sanjay", "Dinesh", "Pawan", "Rakesh", "Suresh", "Ajay"],
              "F": ["Sunita", "Geeta", "Poonam", "Anita", "Meena", "Kiran", "Seema", "Neha", "Pooja", "Savita", "Rekha", "Sarita"]},
}

SURNAMES = {
    "assamese": ["Gogoi", "Borah", "Das", "Saikia", "Bora", "Hazarika", "Kalita", "Sarma", "Deka", "Phukan", "Neog", "Dutta"],
    "bengali": ["Paul", "Sarkar", "Dey", "Roy", "Ghosh", "Choudhury", "Nath", "Dhar", "Barman", "Das", "Sen", "Bhowmik"],
    "muslim": ["Ahmed", "Hussain", "Ali", "Khan", "Rahman", "Islam", "Begum", "Sheikh", "Mondal", "Laskar", "Choudhury", "Uddin"],
    "tea_tribe": ["Munda", "Oraon", "Tanti", "Karmakar", "Bhumij", "Kurmi", "Nayak", "Gour", "Bauri", "Tirkey", "Kisku", "Lohar"],
    "bodo": ["Basumatary", "Narzary", "Brahma", "Boro", "Mushahary", "Daimary", "Swargiary", "Hajowary", "Goyary", "Wary", "Basumatary", "Owary"],
    "karbi_dimasa": ["Ronghang", "Timung", "Teron", "Engti", "Bey", "Terang", "Hanse", "Phangcho", "Nunisa", "Jidung", "Hojai", "Langthasa"],
    "nepali": ["Gurung", "Thapa", "Rai", "Limbu", "Chhetri", "Sharma", "Subba", "Tamang", "Pradhan", "Adhikari", "Gurung", "Magar"],
    "other": ["Singh", "Yadav", "Prasad", "Kumar", "Sharma", "Jha", "Mishra", "Gupta", "Verma", "Agarwal", "Pandey", "Chauhan"],
}

VILLAGE_STEMS = ["Rangapara", "Borgaon", "Dhekiajuli", "Nahorani", "Kharupetia", "Bhawanipur", "Tamulpur", "Majgaon",
                 "Sarupathar", "Lahorighat", "Chaygaon", "Bijni", "Haflong", "Silchar Gram", "Panbari", "Dhalpur",
                 "Naharkatia", "Moran", "Doomdooma", "Sapekhati", "Titabor", "Teok", "Mangaldai", "Rowta"]

# transliteration and abbreviation variants seen in real registers (applied to synthetic names only)
_SUBS = [("Gogoi", "Gogai"), ("Borah", "Bora"), ("Sarma", "Sharma"), ("Choudhury", "Chowdhury"), ("Hussain", "Hossain"),
         ("Mohammad", "Md"), ("Mohammad", "Mohammed"), ("Ahmed", "Ahmad"), ("Das", "Dash"), ("Rahman", "Rehman"),
         ("Basumatary", "Basumatari"), ("Kumar", "Kumer"), ("Rupam", "Roopam"), ("Subrata", "Subroto"), ("Dipak", "Deepak"),
         ("Jonali", "Jonaly"), ("Nurul", "Nural"), ("Sita", "Seeta"), ("Rina", "Reena"), ("Bishnu", "Bisnu"),
         ("Pranjal", "Pronjol"), ("Hazarika", "Hazarica"), ("Gurung", "Gorung"), ("Saikia", "Saikea")]


def variant_of(text: str, rng: np.random.Generator, surname: bool = False) -> str:
    if not text:
        return text
    r = rng.random()
    for a, b in _SUBS:
        if a in text and r < 0.6:
            return text.replace(a, b)
        if b in text and r < 0.6:
            return text.replace(b, a)
    if r < 0.30:
        g = generic_variant(text, rng)
        if g != text:
            return g
    if r < 0.45 and len(text) > 4:                      # drop or double a letter
        i = int(rng.integers(1, len(text) - 1))
        return text[:i] + text[i + 1:] if rng.random() < 0.5 else text[:i] + text[i] + text[i:]
    if r < 0.60 and not surname and len(text) > 1:      # initial only
        return text[0] + "."
    if r < 0.80 and len(text) > 3:                      # adjacent swap
        i = int(rng.integers(1, len(text) - 2))
        return text[:i] + text[i + 1] + text[i] + text[i + 2:]
    return text


# --- more diverse first names: syllable-built names mixed with the curated lists (keeps collision rates realistic) ---
_SYLL = {
    "assamese": ["ra", "pu", "di", "bha", "na", "ji", "he", "ka", "ma", "bi", "pra", "ni", "su", "ho", "mu", "tri", "ga", "lo"],
    "bengali": ["su", "ta", "a", "bi", "pra", "san", "ga", "ni", "ra", "sou", "de", "mou", "ban", "shya", "ko", "pa", "shi", "mo"],
    "muslim": ["ab", "mo", "raf", "nu", "sa", "jah", "an", "miz", "ha", "kut", "sam", "faz", "ar", "iq", "ja", "ru", "ma", "ta"],
    "tea_tribe": ["bu", "su", "man", "ra", "bik", "dha", "san", "bir", "ja", "pa", "som", "phul", "lak", "ru", "bas", "du", "kam", "chan"],
    "bodo": ["mwn", "jwng", "dwh", "gwl", "bi", "har", "na", "ra", "san", "bid", "kha", "lak", "gi", "phu", "ni", "ban", "sew", "hwj"],
    "karbi_dimasa": ["jon", "hol", "sin", "dha", "ka", "bid", "rong", "nil", "jay", "long", "ro", "ma", "sar", "bis", "an", "pus", "lak", "may"],
    "nepali": ["bish", "dil", "pre", "kri", "ga", "ha", "nar", "su", "til", "dam", "ra", "bhi", "sa", "la", "ma", "ki", "pu", "de"],
    "other": ["ra", "su", "vi", "ram", "a", "mu", "san", "di", "pa", "ra", "suh", "aj", "poo", "gee", "mee", "kir", "se", "ne"],
}
_END = {"M": ["n", "l", "k", "m", "t", "jit", "ndra", "war", "sh", "nth", "dev", "raj"], "F": ["a", "i", "ni", "li", "ta", "mi", "ka", "ma", "ri", "ti", "shi", "ya"]}


def first_name(rng: np.random.Generator, community: str, sex: str) -> str:
    pool = FIRST_NAMES[community]["M" if sex == "M" else "F"]
    if rng.random() < 0.35:
        return pool[rng.integers(len(pool))]
    syl = _SYLL[community]
    n = int(rng.integers(1, 3))
    stem = "".join(syl[rng.integers(len(syl))] for _ in range(n))
    return (stem + _END["M" if sex == "M" else "F"][rng.integers(12)]).capitalize()


_GENERIC_SUBS = [("ee", "i"), ("oo", "u"), ("sh", "s"), ("th", "t"), ("w", "v"), ("ph", "f"), ("a", "o"), ("aa", "a"), ("kh", "k"), ("ya", "ia")]


def generic_variant(text: str, rng: np.random.Generator) -> str:
    cands = [(a, b) for a, b in _GENERIC_SUBS if a in text.lower()]
    if cands:
        a, b = cands[int(rng.integers(len(cands)))]
        return text.lower().replace(a, b, 1).capitalize()
    return text
